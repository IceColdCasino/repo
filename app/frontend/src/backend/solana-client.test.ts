import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SEATING_OPS,
  SolanaPokerClient,
  DEFAULT_CHAIN_WORKER_URL,
  DEFAULT_SOLANA_RPC_URL,
  resolveChainWorkerBase,
  resolveOptionalChainWorkerBase,
  resolveSolanaRpcUrl,
  resolveSolanaTableApiBase,
  createPokerClient,
  ActionKind,
  mergeWorkerIntoChainSnapshot,
  isChainPhaseForward,
  phaseFromChainAdvanced,
  type GameSnapshot,
} from './client';
import {
  PLAYER_ACTION_REQUIRED_DISC,
  PHASE_ADVANCED_DISC,
  BET_EVENT_DISC,
  STREET_ADVANCED_DISC,
} from '@poker-src/chain/player-action-events';

function baseSnap(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    gameId: 'solana-local-table',
    backend: 'solana',
    phase: 'lobby',
    dealerSeat: 0,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    smallBlind: '10',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    seats: [],
    pots: [],
    ...overrides,
  };
}

function mockedFetch(): {
  mock: { calls: unknown[][] };
  mockResolvedValueOnce: (value: Response) => void;
} {
  return globalThis.fetch as unknown as {
    mock: { calls: unknown[][] };
    mockResolvedValueOnce: (value: Response) => void;
  };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function programData(raw: Uint8Array): string {
  return `Program data: ${Buffer.from(raw).toString('base64')}`;
}

function betEvent(playerIndex: number, action: number, amount: bigint, flags = [0, 0, 0]): string {
  return programData(concatBytes(
    BET_EVENT_DISC,
    Uint8Array.from([playerIndex, action]),
    u64le(amount),
    Uint8Array.from(flags),
  ));
}

function streetAdvancedEvent(
  fromBettingPhase: number,
  bettingPhase: number,
  phase: number,
  currentPlayer: number,
): string {
  return programData(concatBytes(
    STREET_ADVANCED_DISC,
    new Uint8Array(32),
    Uint8Array.from([fromBettingPhase, bettingPhase, phase, currentPlayer]),
  ));
}

describe('SolanaPokerClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    delete (window as { __ZK_LAUNCH_CONFIG?: unknown }).__ZK_LAUNCH_CONFIG;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            gameId: 'solana-local-table',
            backend: 'solana',
            phase: 'lobby',
            dealerSeat: 0,
            smallBlindSeat: -1,
            bigBlindSeat: -1,
            smallBlind: '10',
            currentBet: '0',
            currentPlayerSeat: null,
            currentPlayerIndex: null,
            bettingRoundOpen: false,
            seats: [],
            pots: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.history.replaceState({}, '', '/');
    delete (window as { __ZK_LAUNCH_CONFIG?: unknown }).__ZK_LAUNCH_CONFIG;
  });

  it('optional worker routes game ops to :3850 when configured', async () => {
    const client = new SolanaPokerClient({
      rpcUrl: 'http://127.0.0.1:8899',
      workerUrl: 'http://127.0.0.1:3850',
    });
    await client.getGame('solana-local-table');
    await client.joinGame('solana-local-table', 0, 'pk0');
    await client.startHand('solana-local-table');
    await client.registerHandKey('solana-local-table', 0, {}, ['1', '2']);

    const urls = mockedFetch().mock.calls.map((call) => String(call[0]));
    expect(urls.every((u) => u.startsWith('http://127.0.0.1:3850/'))).toBe(true);
    expect(urls.some((u) => u.includes(':3847'))).toBe(false);
    expect(urls).toContain('http://127.0.0.1:3850/api/game');
    expect(urls).toContain('http://127.0.0.1:3850/api/game/join');
    expect(urls).toContain('http://127.0.0.1:3850/api/game/start');
    expect(urls).toContain('http://127.0.0.1:3850/api/game/register');
  });

  it('RPC-only getGame returns last snapshot without HTTP when noChainWorker', async () => {
    window.history.replaceState({}, '', '?noChainWorker=1');
    const client = new SolanaPokerClient({
      rpcUrl: DEFAULT_SOLANA_RPC_URL,
      workerUrl: null,
    });
    const snap = await client.getGame('solana-local-table');
    expect(snap.gameId).toBe('solana-local-table');
    expect(snap.backend).toBe('solana');
    expect(mockedFetch().mock.calls.length).toBe(0);
  });

  it('applies PlayerActionRequired logs to turn state without worker', () => {
    const client = new SolanaPokerClient({ workerUrl: null });
    const gameId = new Uint8Array(32).fill(1);
    const body = concatBytes(gameId, Uint8Array.from([0, ActionKind.Bet, 3, 1]));
    const raw = concatBytes(PLAYER_ACTION_REQUIRED_DISC, body);
    const b64 = Buffer.from(raw).toString('base64');
    Object.assign((client as unknown as { lastSnapshot: Record<string, unknown> }).lastSnapshot, {
      actionOrder: [0, 1],
    });
    const snap = client.applyLogsToSnapshot([`Program data: ${b64}`]);
    expect(snap.currentPlayerIndex).toBe(0);
    expect(snap.bettingRoundOpen).toBe(true);
    expect(snap.phase).toBe('PreFlop');
  });

  it('applies a BetEvent to seat bet/currentBet/pot immediately (no poll delay)', () => {
    const client = new SolanaPokerClient({ workerUrl: null });
    Object.assign((client as unknown as { lastSnapshot: GameSnapshot }).lastSnapshot, {
      phase: 'Flop',
      actionOrder: [0, 1],
      playerIndexBySeat: { 0: 0, 1: 1 },
      currentBet: '0',
      pots: [{ amount: '0', lastBet: '0' }],
      seats: [
        { seat: 0, name: 'a', publicKey: 'pk0', playerIndex: 0, chips: '1000', bet: '0', folded: false, active: true },
        { seat: 1, name: 'b', publicKey: 'pk1', playerIndex: 1, chips: '1000', bet: '0', folded: false, active: false },
      ],
    });

    const snap = client.applyLogsToSnapshot([betEvent(0, 3, 40n)]);
    const seat0 = snap.seats.find((s) => s.seat === 0);
    expect(seat0?.bet).toBe('40');
    expect(snap.currentBet).toBe('40');
    expect(snap.pots[0]?.amount).toBe('40');
    expect(snap.pots[0]?.lastBet).toBe('40');
  });

  it('keeps currentBet when a call adds chips but does not raise', () => {
    const client = new SolanaPokerClient({ workerUrl: null });
    Object.assign((client as unknown as { lastSnapshot: GameSnapshot }).lastSnapshot, {
      phase: 'Flop',
      actionOrder: [0, 1],
      playerIndexBySeat: { 0: 0, 1: 1 },
      currentBet: '40',
      pots: [{ amount: '40', lastBet: '40' }],
      seats: [
        { seat: 0, name: 'a', publicKey: 'pk0', playerIndex: 0, chips: '960', bet: '40', folded: false, active: false },
        { seat: 1, name: 'b', publicKey: 'pk1', playerIndex: 1, chips: '1000', bet: '0', folded: false, active: true },
      ],
    });

    const snap = client.applyLogsToSnapshot([betEvent(1, 2, 40n)]);
    const seat1 = snap.seats.find((s) => s.seat === 1);
    expect(seat1?.bet).toBe('40');
    expect(snap.currentBet).toBe('40');
    expect(snap.pots[0]?.amount).toBe('80');
  });

  it('applies a StreetAdvancedEvent to advance the next street immediately', () => {
    const client = new SolanaPokerClient({ workerUrl: null });
    Object.assign((client as unknown as { lastSnapshot: GameSnapshot }).lastSnapshot, {
      phase: 'PreFlop',
      actionOrder: [0, 1],
      playerIndexBySeat: { 0: 0, 1: 1 },
      currentBet: '20',
      seats: [
        { seat: 0, name: 'a', publicKey: 'pk0', playerIndex: 0, chips: '980', bet: '20', folded: false, active: false },
        { seat: 1, name: 'b', publicKey: 'pk1', playerIndex: 1, chips: '980', bet: '20', folded: false, active: true },
      ],
    });

    const snap = client.applyLogsToSnapshot([streetAdvancedEvent(1, 2, 3, 0)]);
    expect(snap.phase).toBe('Flop');
    expect(snap.currentPlayerIndex).toBe(0);
    expect(snap.currentBet).toBe('0');
    expect(snap.seats.every((s) => s.bet === '0')).toBe(true);
  });

  it('does not resurrect a just-closed street when BetEvent arrives after StreetAdvancedEvent', () => {
    const client = new SolanaPokerClient({ workerUrl: null });
    Object.assign((client as unknown as { lastSnapshot: GameSnapshot }).lastSnapshot, {
      phase: 'PreFlop',
      actionOrder: [0, 1],
      playerIndexBySeat: { 0: 0, 1: 1 },
      currentBet: '20',
      pots: [{ amount: '20', lastBet: '20' }],
      seats: [
        { seat: 0, name: 'a', publicKey: 'pk0', playerIndex: 0, chips: '990', bet: '10', folded: false, active: false },
        { seat: 1, name: 'b', publicKey: 'pk1', playerIndex: 1, chips: '980', bet: '20', folded: false, active: true },
      ],
    });

    const snap = client.applyLogsToSnapshot([
      streetAdvancedEvent(1, 2, 3, 0),
      betEvent(0, 2, 10n),
    ]);
    expect(snap.phase).toBe('Flop');
    expect(snap.currentBet).toBe('0');
    expect(snap.seats.every((s) => s.bet === '0')).toBe(true);
    expect(snap.pots[0]?.amount).toBe('30');
  });

  it('closes bettingRoundOpen when StreetAdvancedEvent enters Showdown', () => {
    const client = new SolanaPokerClient({ workerUrl: null });
    Object.assign((client as unknown as { lastSnapshot: GameSnapshot }).lastSnapshot, {
      phase: 'River',
      actionOrder: [0, 1],
      playerIndexBySeat: { 0: 0, 1: 1 },
      bettingRoundOpen: true,
      currentBet: '40',
      seats: [
        { seat: 0, name: 'a', publicKey: 'pk0', playerIndex: 0, chips: '940', bet: '40', folded: false, active: false },
        { seat: 1, name: 'b', publicKey: 'pk1', playerIndex: 1, chips: '940', bet: '40', folded: false, active: true },
      ],
    });

    const snap = client.applyLogsToSnapshot([streetAdvancedEvent(4, 5, 5, 0)]);
    expect(snap.phase).toBe('Showdown');
    expect(snap.bettingRoundOpen).toBe(false);
    expect(snap.currentPlayerIndex).toBe(0);
  });

  it('legacy string ctor still targets worker for ops', async () => {
    const client = new SolanaPokerClient('http://127.0.0.1:3850');
    expect(client.hasOptionalWorker).toBe(true);
    await client.getGame('solana-local-table');
    expect(String(mockedFetch().mock.calls[0]![0])).toBe(
      `${DEFAULT_CHAIN_WORKER_URL}/api/game`,
    );
  });

  it('createPokerClient(solana, baseUrl) uses the given worker URL', async () => {
    const client = createPokerClient('solana', 'http://127.0.0.1:3999');
    await client.getGame('solana-local-table');
    expect(String(mockedFetch().mock.calls[0]![0])).toBe('http://127.0.0.1:3999/api/game');
  });

  it('createPokerClient(solana) defaults to native bridge path (no HTTP table API)', async () => {
    window.history.replaceState({}, '', '?backend=solana&noChainWorker=1');
    const client = createPokerClient('solana') as SolanaPokerClient;
    expect(client.workerUrl).toBeNull();
    expect(resolveSolanaTableApiBase()).toBeNull();
    await client.getGame('solana-local-table');
    expect(mockedFetch().mock.calls.length).toBe(0);
  });

  it('resolveOptionalChainWorkerBase ignores apiBase (no longer implies :3850)', () => {
    window.history.replaceState({}, '', '?backend=solana&apiBase=http://127.0.0.1:3850');
    expect(resolveOptionalChainWorkerBase()).toBeNull();
  });

  it('resolveOptionalChainWorkerBase uses explicit chainWorker', () => {
    window.history.replaceState({}, '', '?backend=solana&chainWorker=http://127.0.0.1:3850');
    expect(resolveOptionalChainWorkerBase()).toBe('http://127.0.0.1:3850');
  });

  it('resolveSolanaTableApiBase honors explicit tableApi', () => {
    window.history.replaceState({}, '', '?backend=solana&tableApi=http://127.0.0.1:5178');
    expect(resolveSolanaTableApiBase()).toBe('http://127.0.0.1:5178');
  });

  it('resolveChainWorkerBase defaults to :3850 for tooling', () => {
    expect(resolveChainWorkerBase()).toBe('http://127.0.0.1:3850');
  });

  it('resolveOptionalChainWorkerBase is null without query/launch', () => {
    expect(resolveOptionalChainWorkerBase()).toBeNull();
  });

  it('resolveSolanaRpcUrl defaults to :8899', () => {
    expect(resolveSolanaRpcUrl()).toBe('http://127.0.0.1:8899');
  });

  it('isChainPhaseForward rejects Register after Shuffle', () => {
    expect(isChainPhaseForward('Shuffle', 'Register')).toBe(false);
    expect(isChainPhaseForward('Shuffle', 'Share')).toBe(true);
    expect(isChainPhaseForward('Complete', 'Register')).toBe(true);
  });

  it('isChainPhaseForward rejects raw lobby snapshot mid-hand', () => {
    expect(isChainPhaseForward('Register', 'lobby')).toBe(false);
    expect(isChainPhaseForward('Shuffle', 'lobby')).toBe(false);
    expect(isChainPhaseForward('Complete', 'lobby')).toBe(true);
    expect(isChainPhaseForward('lobby', 'lobby')).toBe(true);
  });

  it('mergeWorkerIntoChainSnapshot keeps Register when worker is raw lobby', () => {
    const chain = baseSnap({
      phase: 'Register',
      handNumber: 1,
      currentPlayerIndex: 0,
      currentPlayerSeat: 0,
      playerIndexBySeat: { 0: 0, 1: 1 },
      zk: { registeredCount: 0, elGamalPublicKeys: [null, null] } as GameSnapshot['zk'],
      seats: [
        { seat: 0, name: 'a', publicKey: 'pk0', chips: '5000' },
        { seat: 1, name: 'b', publicKey: 'pk1', chips: '5000' },
      ],
    });
    const worker = baseSnap({
      phase: 'lobby',
      seats: [
        { seat: 0, name: 'a', publicKey: 'pk0', chips: '5000' },
        { seat: 1, name: 'b', publicKey: 'pk1', chips: '5000' },
      ],
    });
    const merged = mergeWorkerIntoChainSnapshot(chain, worker);
    expect(merged.phase).toBe('Register');
    expect(merged.handNumber).toBe(1);
    expect(merged.zk?.registeredCount).toBe(0);
    expect(merged.playerIndexBySeat?.[0]).toBe(0);
  });

  it('mergeWorkerIntoChainSnapshot rejects lagging worker phase', () => {
    const chain = baseSnap({
      phase: 'Shuffle',
      currentPlayerIndex: 1,
      currentPlayerSeat: 1,
      bettingRoundOpen: false,
      seats: [
        { seat: 0, name: 'a', publicKey: 'pk0', chips: '100', active: false },
        { seat: 1, name: 'b', publicKey: 'pk1', chips: '100', active: true },
      ],
    });
    const worker = baseSnap({
      phase: 'Register',
      currentPlayerIndex: 0,
      currentPlayerSeat: 0,
      bettingRoundOpen: false,
      seats: [
        { seat: 0, name: 'a', publicKey: 'pk0', chips: '100', active: true },
        { seat: 1, name: 'b', publicKey: 'pk1', chips: '100', active: false },
      ],
      zk: { registeredCount: 1 } as GameSnapshot['zk'],
    });
    const merged = mergeWorkerIntoChainSnapshot(chain, worker);
    expect(merged.phase).toBe('Shuffle');
    expect(merged.currentPlayerIndex).toBe(1);
    expect(merged.currentPlayerSeat).toBe(1);
    expect(merged.zk?.registeredCount).toBe(1);
    expect(merged.seats[1]?.active).toBe(true);
  });

  it('mergeWorkerIntoChainSnapshot keeps chain bettingRoundOpen when worker lags', () => {
    const chain = baseSnap({
      phase: 'PreFlop',
      bettingRoundOpen: true,
      currentPlayerIndex: 0,
      currentPlayerSeat: 0,
    });
    const worker = baseSnap({
      phase: 'Share',
      bettingRoundOpen: false,
      currentPlayerIndex: 1,
      currentPlayerSeat: 1,
    });
    const merged = mergeWorkerIntoChainSnapshot(chain, worker);
    expect(merged.phase).toBe('PreFlop');
    expect(merged.bettingRoundOpen).toBe(true);
    expect(merged.currentPlayerIndex).toBe(0);
  });

  it('getGame does not regress phase when worker snapshot is stale', async () => {
    const client = new SolanaPokerClient({
      rpcUrl: DEFAULT_SOLANA_RPC_URL,
      workerUrl: 'http://127.0.0.1:3850',
    });
    Object.assign((client as unknown as { lastSnapshot: GameSnapshot }).lastSnapshot, {
      phase: 'Shuffle',
      currentPlayerIndex: 0,
      currentPlayerSeat: 0,
    });
    mockedFetch().mockResolvedValueOnce(
      new Response(
        JSON.stringify(baseSnap({
          phase: 'Register',
          currentPlayerIndex: 1,
          currentPlayerSeat: 1,
          seats: [
            { seat: 0, name: 'a', publicKey: 'pk0', chips: '100' },
            { seat: 1, name: 'b', publicKey: 'pk1', chips: '100' },
          ],
        })),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const snap = await client.getGame('solana-local-table');
    expect(snap.phase).toBe('Shuffle');
    expect(snap.currentPlayerIndex).toBe(0);
    expect(snap.seats).toHaveLength(2);
  });

  it('applies PhaseAdvancedEvent to snapshot phase', () => {
    const client = new SolanaPokerClient({ workerUrl: null });
    const gameId = new Uint8Array(32).fill(2);
    // phase=1 Shuffle, bettingPhase=0, currentPlayer=0
    const body = concatBytes(gameId, Uint8Array.from([1, 0, 0]));
    const raw = concatBytes(PHASE_ADVANCED_DISC, body);
    const b64 = Buffer.from(raw).toString('base64');
    Object.assign((client as unknown as { lastSnapshot: GameSnapshot }).lastSnapshot, {
      phase: 'Register',
      actionOrder: [0, 1],
    });
    const snap = client.applyLogsToSnapshot([`Program data: ${b64}`]);
    expect(snap.phase).toBe('Shuffle');
    expect(snap.currentPlayerIndex).toBe(0);
  });

  it('PhaseAdvancedEvent to Flop reveals flop deal indices for board rendering', () => {
    const client = new SolanaPokerClient({ workerUrl: null });
    const gameId = new Uint8Array(32).fill(4);
    // phase remains Evaluation-ish, bettingPhase=2 means UI Flop.
    const body = concatBytes(gameId, Uint8Array.from([3, 2, 0]));
    const raw = concatBytes(PHASE_ADVANCED_DISC, body);
    const b64 = Buffer.from(raw).toString('base64');
    Object.assign((client as unknown as { lastSnapshot: GameSnapshot }).lastSnapshot, {
      phase: 'PreFlop',
      actionOrder: [0, 1],
      playerIndexBySeat: { 0: 0, 1: 1 },
      zkReveal: {
        revealedCardIndices: [],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    });

    const snap = client.applyLogsToSnapshot([`Program data: ${b64}`]);

    expect(snap.phase).toBe('Flop');
    expect(snap.zkReveal?.revealedCardIndices).toEqual([20, 21, 22]);
  });

  it('Evaluation (phase=3) after Share maps to PreFlop, not Showdown', () => {
    const client = new SolanaPokerClient({ workerUrl: null });
    const gameId = new Uint8Array(32).fill(3);
    // On-chain: share complete → phase=3 Evaluation, betting_phase=0
    const body = concatBytes(gameId, Uint8Array.from([3, 0, 0]));
    const raw = concatBytes(PHASE_ADVANCED_DISC, body);
    const b64 = Buffer.from(raw).toString('base64');
    Object.assign((client as unknown as { lastSnapshot: GameSnapshot }).lastSnapshot, {
      phase: 'Share',
      actionOrder: [0, 1],
      holesViewPending: true,
    });
    const snap = client.applyLogsToSnapshot([`Program data: ${b64}`]);
    expect(snap.phase).toBe('PreFlop');
    expect(phaseFromChainAdvanced({
      gameId,
      phase: 3,
      bettingPhase: 0,
      currentPlayer: 0,
    })).toBe('PreFlop');
    expect(phaseFromChainAdvanced({
      gameId,
      phase: 3,
      bettingPhase: 1,
      currentPlayer: 0,
    })).toBe('PreFlop');
    expect(phaseFromChainAdvanced({
      gameId,
      phase: 5,
      bettingPhase: 5,
      currentPlayer: 0,
    })).toBe('Showdown');
  });

  it('PhaseAdvancedEvent to Showdown marks all partials public', () => {
    const client = new SolanaPokerClient({ workerUrl: null });
    const gameId = new Uint8Array(32).fill(5);
    const body = concatBytes(gameId, Uint8Array.from([5, 5, 0]));
    const raw = concatBytes(PHASE_ADVANCED_DISC, body);
    const b64 = Buffer.from(raw).toString('base64');
    Object.assign((client as unknown as { lastSnapshot: GameSnapshot }).lastSnapshot, {
      phase: 'River',
      actionOrder: [0, 1],
      zkReveal: {
        revealedCardIndices: [20, 21, 22, 23, 24],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    });
    const snap = client.applyLogsToSnapshot([`Program data: ${b64}`]);
    expect(snap.phase).toBe('Showdown');
    expect(snap.zkReveal?.allPartialsPublic).toBe(true);
    expect(snap.zkReveal?.revealedCardIndices).toEqual([20, 21, 22, 23, 24]);
  });

  it('attaches the local seat key to showdown materials', () => {
    expect(SEATING_OPS.has('getShowdownMaterials')).toBe(true);
    expect(SEATING_OPS.has('showdownMaterials')).toBe(true);
    expect(SEATING_OPS.has('submitShowdown')).toBe(true);
  });
});
